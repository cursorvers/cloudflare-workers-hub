# FUGUE Cockpit Architecture Diagrams

このディレクトリには FUGUE (Federated Unified Governance for Universal Execution) Cockpit の全体設計を可視化した Mermaid ダイアグラムが含まれています。

## 📐 ダイアグラム一覧

### 1. [system-overview.mmd](./system-overview.mmd) - システム全体図

**目的**: FUGUE Cockpit のレイヤー構造と主要コンポーネントを俯瞰

**レイヤー構成**:
- **👤 User Layer**: PWA（タスクダッシュボード、Git モニター、承認 UI）
- **⚡ Edge Layer**: Cloudflare Workers Hub（タスクキュー、認証、Webhook ルーティング）
- **💻 Local Layer**: Mac デーモン（Git 監視、ファイルシステムアクセス）
- **🚀 Execution Layer**: Claude Orchestrator → 実行エージェント群
  - Claude Code（メイン実装）
  - Codex（設計・セキュリティ）
  - GLM-4.7（レビュー・計算）
  - Pencil MCP（デザイン実装）
  - Excalidraw（ダイアグラム）
  - Subagent（調査・並列）
- **🔍 Evaluation Layer**: 自動品質評価
  - **Gemini**: UI/UX 評価
  - **GLM**: コード品質評価
  - **Codex**: セキュリティ評価
- **📊 Reporting Layer**: フィードバック統合と報告

**視覚化のポイント**:
- 各レイヤーの独立性と連携フロー
- Gemini がデザイン評価層に配置
- 並列実行可能な箇所

---

### 2. [data-flow.mmd](./data-flow.mmd) - データフロー図

**目的**: タスク実行の具体的な処理フローを詳細に表現

**含まれるフロー**:

#### 📋 Task Execution Flow
1. **ルーティング**: タスクタイプごとに適切なエージェントへ委譲
2. **実行**: GLM / Codex / Gemini / Claude / Subagent が並列実行
3. **評価**: 成果物タイプに応じて評価層へ自動トリガー
   - UI/Design → **Gemini** (Visual Consistency, UX Quality, Brand Alignment)
   - Code → **GLM** (7pt Quality Check)
   - Security → **Codex** (Vulnerability Scan, OWASP Top 10)
4. **フィードバック統合**: Quality Gate で品質判定
5. **イテレーション**: 不合格時は自動リトライ

#### 🔍 Git Monitor Flow
1. **変更検出**: 5秒間隔で Git Diff をポーリング
2. **コミット前チェック**: `parallel-codex.js` で並列レビュー
   - GLM Code Reviewer (7pt)
   - Codex Security Analyst (3pt)
3. **Verdict**: 10点満点で判定
   - 9-10: APPROVE_RECOMMENDED
   - 7-8: APPROVE_ALLOWED
   - 5-6: FIX_RECOMMENDED
   - 0-4: FIX_REQUIRED
4. **自動レビュー**: 10行以上の変更で GLM が自動レビュー

#### ⚠️ Dangerous Operation Flow
1. **リスクレベル判定**:
   - Level 1（システム破壊的）→ ユーザー確認必須
   - Level 2（その他危険）→ 3者合議制
2. **3者合議**:
   - Claude（自己評価）
   - Codex Security（セキュリティ判断）
   - **Gemini（UI/UX 関連時）** または **GLM-4.7（デフォルト）**
3. **投票結果**:
   - 3者承認 → 即時実行
   - 2者承認 → 条件付き実行（ログ記録）
   - 1者承認 → 却下（代替案提示）
   - 0者承認 → 完全却下

---

### 3. [component-diagram.mmd](./component-diagram.mmd) - コンポーネント図

**目的**: 各レイヤーの内部コンポーネントと依存関係を詳細化

**主要コンポーネント**:

#### 📱 PWA Components
- Task Dashboard（タスク管理）
- Git Monitor UI（コミットログ・Diff ビューア）
- Approval Interface（3者投票表示）
- Settings Panel（エージェント設定）

#### ⚡ Cloudflare Workers Hub
- **API Routes**:
  - `/api/tasks` (CRUD)
  - `/api/webhooks` (GitHub, Stripe, Custom)
  - `/api/auth` (JWT 検証)
  - `/api/health` (システムステータス)
- **Services**:
  - Task Service（キュー管理、リトライロジック）
  - Auth Service（RBAC、監査ログ）
  - Notification Service（Discord, Email, Webhook）
- **Storage**:
  - D1 Database（tasks, sessions, audit_logs, quality_gates）
  - KV Store（config, cache, rate_limits）
  - Queue（task_queue, retry_queue, dead_letter）

#### 💻 Local Agent (Mac)
- **Daemon (Port 3999)**:
  - Git Watcher（ファイルシステム監視）
  - Task Executor（Subagent ランチャー）
  - Health Check（30秒ハートビート）
- **MCP Servers**:
  - Codex MCP（GPT Pro API）
  - Pencil MCP（.pen ファイルハンドラ）
  - Excalidraw MCP（Mermaid 変換）
  - GLM MCP（7並列最大）
- **File System**:
  - Workspace（Git リポジトリ、Plans.md）
  - Config（.claude/CLAUDE.md, rules/, settings.json）
  - Cache（codex-summaries/, memories/, artifacts/）

#### 🚀 Execution Agents
- Claude Code（メインオーケストレーター）
- Codex Agents（architect, scope-analyst, plan-reviewer, security-analyst, code-reviewer）
- GLM Agents（code-reviewer, math-reasoning, refactor-advisor, general-reviewer）
- **Gemini Agents（ui-reviewer, image-analyst）**
- Subagent Pool（Explore, Bash, Plan）

#### 🔍 Evaluation Agents
- **Gemini UI/UX**（デザイン評価、スクリーンショット分析、ブランドチェック）
- **GLM Code Review**（7点品質、可読性、パフォーマンス）
- **Codex Security**（脆弱性スキャン、OWASP Top 10、3点セキュリティ）

---

### 4. [evaluation-flow.mmd](./evaluation-flow.mmd) - 評価層フロー

**目的**: 成果物の自動評価プロセスを詳細化（Gemini の役割を明確化）

**評価経路**:

#### UI/UX 評価経路（Gemini）
1. **トリガー**: `.pen`, `.tsx`, `.vue` ファイルの変更
2. **前処理**: Pencil の場合は `get_screenshot` で画像化
3. **評価基準**:
   - **Visual Consistency**: 色調和、タイポグラフィ、レイアウトバランス
   - **UX Quality**: ナビゲーションフロー、アクセシビリティ、レスポンシブ
   - **Brand Alignment**: デザインシステム、コンポーネント再利用、スタイルガイド
4. **出力**: スコア 1-10、問題リスト、改善提案

#### コード評価経路（GLM）
1. **トリガー**: 10行以上のコード変更
2. **評価基準（7点満点）**:
   - **Readability (2pt)**: 命名、構造、コメント
   - **Maintainability (2pt)**: モジュール性、結合度、複雑度
   - **Performance (2pt)**: 効率、リソース使用、最適化
   - **Correctness (1pt)**: ロジック、エッジケース、エラーハンドリング
3. **出力**: スコア 0-7、問題リスト、リファクタリング提案

#### セキュリティ評価経路（Codex）
1. **トリガー**: `auth/`, `api/`, `payment/` 関連の変更
2. **評価基準（3点満点）**:
   - **Vulnerability Scan (1pt)**: SQL Injection, XSS, CSRF
   - **OWASP Top 10 (1pt)**: Broken Access, Crypto Failures, Insecure Design
   - **Auth Security (1pt)**: セッション管理、トークン検証、レート制限
3. **出力**: スコア 0-3、脆弱性リスト、修正手順

#### 統合と判定
1. **Claude Integration Layer**: 全評価結果を統合
2. **Quality Gate Check**:
   - Code Quality: Min 5/7, Recommended 6/7
   - Security: Min 2/3, Recommended 3/3
   - UI/UX: Min 6/10, Recommended 8/10
3. **Verdict**:
   - ≥90%: APPROVE_RECOMMENDED ✅
   - 70-89%: APPROVE_ALLOWED ✓
   - 50-69%: FIX_RECOMMENDED ⚠️
   - <50%: FIX_REQUIRED ❌
4. **ユーザーアクション**: Accept / Iterate / Override

**並列実行**: Gemini, GLM, Codex は独立して並列評価可能

---

## 🎨 カラーコーディング

各ダイアグラムは一貫したカラースキームを使用:

| 色 | 用途 | HEX |
|----|------|-----|
| 🔵 Blue | User Layer, Start Points | #e1f5ff |
| 🟠 Orange | Edge Layer (Cloudflare) | #fff3e0 |
| 🟣 Purple | Local Layer (Mac) | #f3e5f5 |
| 🟢 Green | Execution Layer | #e8f5e9 |
| 🟡 Yellow | Evaluation Layer, Quality Gates | #fff9c4 |
| 🔴 Pink | Reporting, End Points | #fce4ec |
| 🔴 Red | Dangerous Operations | #ffebee |

---

## 🔧 Mermaid の使い方

### オンラインビューア
- [Mermaid Live Editor](https://mermaid.live/)
- [GitHub Markdown](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams) (`.mmd` を `.md` にコピー)

### VS Code 拡張機能
```bash
code --install-extension bierner.markdown-mermaid
```

### CLI でエクスポート
```bash
# PNG にエクスポート
npx @mermaid-js/mermaid-cli -i system-overview.mmd -o system-overview.png

# SVG にエクスポート
npx @mermaid-js/mermaid-cli -i system-overview.mmd -o system-overview.svg
```

---

## 📋 更新履歴

| 日付 | 変更内容 |
|------|---------|
| 2026-01-28 | 初版作成（Gemini を評価層に統合） |

---

## 📖 関連ドキュメント

- [FUGUE ガイドライン](../../../.claude/CLAUDE.md)
- [委譲マトリクス](../../../.claude/rules/delegation-matrix.md)
- [評価層フロー](../../../.claude/rules/auto-execution.md)
- [危険操作の合議制](../../../.claude/rules/dangerous-permission-consensus.md)

---

## 🤝 貢献

ダイアグラムの改善提案は Issue または PR でお願いします。

**更新時の注意**:
1. カラースキームを維持
2. Gemini の役割（UI/UX 評価）を明確化
3. 他のダイアグラムとの整合性を確認
4. Mermaid 構文の検証（[Mermaid Live](https://mermaid.live/)）
