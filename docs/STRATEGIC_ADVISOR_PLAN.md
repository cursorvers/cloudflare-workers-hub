# FUGUE Strategic Advisor - 設計プラン

> **目的**: 単なる監視ではなく、**思考パートナー**として機能する本質的提案システム

## 1. コンセプト

```
従来のアラート                    Strategic Advisor
─────────────────────────────────────────────────────
"12 変更あります"           →    "認証と決済、統合すべきでは？"
"ファイルが大きい"          →    "このアーキテクチャは半年後に破綻"
"タスク滞留"               →    "本当に必要？目的に立ち返って"
```

### 本質的提案の特徴

| 視点 | 説明 |
|------|------|
| **意図の理解** | 何をしているか → **何を達成したいか** |
| **パターンの接続** | 点 → **線として見る** |
| **先読み** | 今の問題 → **未来の問題を予防** |
| **本質への問い** | やり方 → **そもそも必要か？** |

---

## 2. 参考実装パターン（調査結果）

### Linear Triage Intelligence
- **信頼の3原則**: Trust（根拠を示す）、Transparency（推論を可視化）、Natural（自然に統合）
- **処理時間**: 1-4分かけて高品質な提案

### Cursor/Devin Intent Engineering
- **意図ベースエンジニアリング**: 品質 = 制約定義 + 高レベルロジック
- **チェックポイント**: Planning → PR（検証必須）

### Mem0 Memory Pattern
- **多層メモリ**: 短期（セッション）+ 長期（クロスセッション）
- **リフレクション**: フィードバックで記憶の重要度を更新

---

## 3. アーキテクチャ

```
┌─────────────────────────────────────────────────────────┐
│  FUGUE Strategic Advisor                                │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  📊 コンテキスト収集層                                   │
│  ├─ Plans.md → Goal[] (フェーズ、タスク、成功基準)      │
│  ├─ agent-memory → Decision[] (過去の判断と理由)        │
│  ├─ harness-usage.json → ProcessHealth (ツール使用状況) │
│  ├─ git log → Velocity (コミット頻度、パターン)         │
│  └─ cockpit-api → SystemState (リポジトリ、タスク状態)  │
│                                                         │
│  🧠 意図推論層 (Workers AI / Claude)                    │
│  ├─ Goal Inference: "何を達成しようとしているか"        │
│  ├─ Pattern Recognition: "繰り返しパターンの検出"       │
│  ├─ Risk Assessment: "将来の問題予測"                   │
│  └─ Priority Analysis: "本当に重要なことは何か"         │
│                                                         │
│  💡 提案生成層                                          │
│  ├─ Strategic: "アーキテクチャ再考すべき"               │
│  ├─ Tactical: "このタスクを分割しては"                  │
│  ├─ Reflective: "先週より生産性20%向上"                 │
│  └─ Questioning: "本当に必要ですか？"                   │
│                                                         │
│  📱 配信層                                              │
│  ├─ PWA Insights Card                                   │
│  ├─ Push Notification (重要なもののみ)                  │
│  └─ Session Start Summary                               │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 4. データスキーマ

### strategic-context.json (SSOT)

```typescript
interface StrategicContext {
  // 目標追跡
  goals: Goal[];
  currentPhase: string;

  // 意思決定履歴
  decisions: Decision[];

  // リスク管理
  risks: Risk[];
  assumptions: Assumption[];

  // プロセス健全性
  velocity: VelocityMetrics;
  toolUsage: ToolUsageMetrics;

  // 最終更新
  updatedAt: number;
  nextReviewAt: number;
}

interface Goal {
  id: string;
  title: string;
  intent: string;          // WHY - なぜこれをするのか
  successCriteria: string[];
  status: 'active' | 'completed' | 'paused';
  priority: 'critical' | 'high' | 'medium' | 'low';
  linkedPlansSection?: string;
}

interface Decision {
  id: string;
  title: string;
  context: string;
  chosen: string;
  rationale: string;       // WHY - なぜこの選択をしたか
  madeAt: number;
  reviewAt?: number;       // いつ再評価すべきか
  sourceMemory?: string;   // agent-memory へのリンク
}

interface Risk {
  id: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  probability: number;
  mitigation: string;
  status: 'active' | 'mitigated' | 'accepted';
}
```

### insight.json (生成された提案)

```typescript
interface Insight {
  id: string;
  type: 'strategic' | 'tactical' | 'reflective' | 'questioning';
  title: string;
  description: string;
  rationale: string;       // なぜこの提案をするのか
  confidence: number;      // 0-1
  priority: 'high' | 'medium' | 'low';
  actionable: boolean;
  suggestedAction?: string;
  relatedGoals?: string[];
  createdAt: number;
  expiresAt?: number;
  dismissed?: boolean;
}
```

---

## 5. 提案パターン

### Strategic（戦略的）
| トリガー | 提案例 |
|---------|--------|
| 同じ問題を3回解決 | "このパターンを共通化すべきでは？" |
| 複数機能が関連 | "認証と決済を統合したサブスクシステムに" |
| 技術負債蓄積 | "このアーキテクチャは6ヶ月後に問題になる" |

### Tactical（戦術的）
| トリガー | 提案例 |
|---------|--------|
| タスク3日以上滞留 | "分割するか、優先度を見直しては？" |
| ファイル500行超過 | "cockpit-api.ts が大きくなっています" |
| ブランチ5日以上 | "長期ブランチは衝突リスクあり" |

### Reflective（内省的）
| トリガー | 提案例 |
|---------|--------|
| 週次サマリー | "先週比で生産性20%向上しています" |
| パターン検出 | "金曜日にコミットを忘れがちです" |
| 達成認識 | "Phase 3 完了おめでとうございます" |

### Questioning（問いかけ）
| トリガー | 提案例 |
|---------|--------|
| 目的不明確なタスク | "これは何のために必要ですか？" |
| 過剰な複雑さ | "もっとシンプルな方法はないですか？" |
| 優先度の矛盾 | "これより先にやるべきことは？" |

---

## 6. 実装フェーズ

### Phase 1: コンテキスト収集（1週目）
- [ ] strategic-context.json スキーマ作成
- [ ] Plans.md パーサー実装
- [ ] agent-memory からの Decision 抽出
- [ ] harness-usage.json からのメトリクス抽出

### Phase 2: 提案エンジン（2週目）
- [ ] Workers AI による意図推論
- [ ] パターン認識ロジック
- [ ] 提案生成ルールエンジン
- [ ] 信頼度スコアリング

### Phase 3: 配信統合（3週目）
- [ ] PWA Insights カード追加
- [ ] Cron トリガー（毎時/毎日）
- [ ] Push 通知統合
- [ ] セッション開始時サマリー

### Phase 4: フィードバックループ（4週目）
- [ ] 提案の受諾/却下追跡
- [ ] 重要度の自動調整
- [ ] パーソナライゼーション

---

## 7. 技術選択

| コンポーネント | 選択 | 理由 |
|---------------|------|------|
| コンテキスト保存 | D1 + KV | 構造化データ + キャッシュ |
| 意図推論 | Workers AI (Llama) | 低コスト、エッジ実行 |
| 高度な分析 | Claude (API) | 複雑な推論が必要な場合 |
| 配信 | PWA + Push | 既存インフラ活用 |
| スケジュール | Cron Trigger | 既存インフラ活用 |

---

## 8. aitmpl.com 活用

- **エージェントテンプレート**: 提案エンジンのスキル構造参考
- **Analytics パターン**: 使用量追跡の実装参考
- **コンポーネント配布**: 将来的に FUGUE テンプレートを公開可能

---

## 9. 成功指標

| 指標 | 目標 |
|------|------|
| 提案受諾率 | > 30% |
| 有用性評価 | > 4/5 |
| 問題の先行検出 | > 50% |
| 意思決定時間短縮 | > 20% |

---

## 10. リスク

| リスク | 軽減策 |
|--------|--------|
| 提案が多すぎて無視される | 優先度フィルタリング、1日3件まで |
| 的外れな提案 | 信頼度スコア表示、フィードバックループ |
| パフォーマンス影響 | バックグラウンド処理、キャッシュ活用 |

---

## 次のアクション

1. **Phase 1 開始**: strategic-context.json スキーマ実装
2. **Plans.md パーサー**: Goal[] 抽出ロジック
3. **PWA カード追加**: Insights セクション

