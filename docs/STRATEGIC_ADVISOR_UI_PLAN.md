# FUGUE Strategic Advisor - UI/UX デザインプラン

> **Gemini + aitmpl.com 調査に基づく実装計画**
> 作成: 2026-01-29

---

## 1. 現状分析（Phase 1 完了時点）

### 実装済み
- [x] スキーマ定義 (`schemas/strategic-advisor.ts`)
- [x] Plans.md パーサー (`services/plans-parser.ts`)
- [x] コンテキスト収集サービス (`services/strategic-context.ts`)
- [x] API エンドポイント (`handlers/strategic-advisor-api.ts`)
- [x] PWA Insights カード（基本版）
- [x] マイグレーション (`0006_strategic_advisor.sql`)

### Gemini による現状評価

| 観点 | スコア | 指摘 |
|------|--------|------|
| Visual Hierarchy | 3/5 | カード羅列で認知負荷高 |
| Consistency | 4/5 | 良好 |
| Accessibility | 3/5 | 色分けのみ |
| Usability | 3/5 | モバイルで処理効率低 |

**Critical Issue**: 提案根拠（なぜその提案？）の透明性不足

---

## 2. aitmpl.com 活用戦略

### 直接的に参考になるテンプレート

| テンプレート | FUGUE への応用 |
|-------------|---------------|
| `multi-agent-coordinator` | Orchestrator 層の設計参考 |
| `knowledge-synthesizer` | Insight 生成ロジック参考 |
| `workflow-orchestrator` | 並列タスク管理参考 |
| `error-coordinator` | 戦略的判断のパターン参考 |

### 補完が必要な領域（aitmpl.com に未提供）

- **Proactive Advisor パターン** - FUGUE が先行実装
- **Strategic Decision Support** - 新規テンプレート候補
- **Long-term Planning Agent** - 新規テンプレート候補

**機会**: aitmpl.com へ逆貢献（FUGUE Strategic Advisor テンプレートを公開）

---

## 3. UI/UX 改善計画（Gemini 提案ベース）

### 3.1 Focus Stack UI（モバイル優先）

**現状**: カードを縦に並列表示 → 認知負荷高

**改善**: カードスタック方式

```
┌─────────────────────────────────┐
│ 💡 今すぐ検討すべき提案          │
│                                 │
│ ┌─────────────────────────────┐ │
│ │ [Strategic]                 │ │
│ │ 認証と決済、統合すべきでは？  │ │
│ │                             │ │
│ │ 信頼度: ████████░░ 80%      │ │
│ │                             │ │
│ │ [← Dismiss] [Snooze ↓] [Accept →]│
│ └─────────────────────────────┘ │
│   ┌───────────────────────────┐  │ ← 背景に次のカード
│   │ タスク分割を検討...        │  │
│   └───────────────────────────┘  │
└─────────────────────────────────┘
```

### 3.2 スワイプジェスチャー（Natural 原則）

| ジェスチャー | アクション | ハプティクス |
|------------|-----------|-------------|
| 右スワイプ | Accept/Save | 軽い振動 |
| 左スワイプ | Dismiss | なし |
| 下スワイプ | Snooze (1h/1d/1w) | 軽い振動 |
| タップ | 詳細展開 | なし |

### 3.3 Confidence Ring（Transparency 原則）

```
┌──────────────────────────────────┐
│ [80%]  認証と決済、統合すべきでは？ │
│  ◐    Strategic | 3h前            │
├──────────────────────────────────┤
│ 📊 Why proposed?                  │
│ - auth.ts と payment.ts で重複    │
│ - 過去3回同じパターンを解決       │
│ - commit#abc123 で関連変更        │
└──────────────────────────────────┘
```

### 3.4 プラットフォーム別 Density

| Platform | UI パターン | フォーカス |
|----------|-----------|-----------|
| iPhone | Focus Stack + スワイプ | 選別・判断 |
| Desktop | 2ペイン（リスト + 詳細） | 深い分析・実装 |
| Watch | 通知のみ | 気づき |

---

## 4. 実装フェーズ（更新版）

### Phase 2: UI/UX 改善（1週目）
- [ ] Focus Stack コンポーネント実装
- [ ] スワイプジェスチャー（Hammer.js）
- [ ] Confidence Ring 視覚化
- [ ] "Why proposed?" セクション追加
- [ ] アクセシビリティ改善（アイコン + ラベル）

### Phase 3: Intelligence 強化（2週目）
- [ ] Workers AI による意図推論
- [ ] パターン認識ロジック（重複検出）
- [ ] 信頼度スコアリングアルゴリズム
- [ ] aitmpl `knowledge-synthesizer` パターン適用

### Phase 4: 配信最適化（3週目）
- [ ] Push 通知統合（高優先度のみ）
- [ ] 配信頻度の自動調整（1日3件上限）
- [ ] セッション開始時サマリー
- [ ] Desktop 2ペインUI

### Phase 5: フィードバックループ（4週目）
- [ ] 受諾/却下追跡
- [ ] 重要度の自動調整
- [ ] パーソナライゼーション
- [ ] aitmpl テンプレート公開準備

---

## 5. 技術選択

| コンポーネント | 選択 | 理由 |
|---------------|------|------|
| ジェスチャー | Hammer.js | 軽量、スワイプサポート |
| アニメーション | CSS Transform | GPU アクセラレーション |
| 信頼度表示 | SVG Ring | カスタマイズ性 |
| 状態管理 | Vanilla JS | PWA インライン HTML 制約 |

---

## 6. 成功指標（更新版）

| 指標 | Phase 1 | Target |
|------|---------|--------|
| 提案受諾率 | - | > 30% |
| 却下理由回収率 | - | > 50% |
| モバイル処理時間/提案 | - | < 3秒 |
| 有用性評価 | - | > 4/5 |
| アラート疲れ報告 | - | < 5% |

---

## 7. 次のアクション

1. **Phase 2 開始**: Focus Stack UI 実装
2. **aitmpl 調査続行**: `knowledge-synthesizer` 詳細確認
3. **Gemini フォローアップ**: Desktop UI デザインレビュー依頼

---

## 参考リソース

- [aitmpl.com](https://www.aitmpl.com/) - Claude Code テンプレートマーケット
- [awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents)
- [Linear Triage Intelligence](https://linear.app/method) - Trust/Transparency/Natural 原則
