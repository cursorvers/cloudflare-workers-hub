# FUGUE Strategic Advisor - 修正プラン

> **4者批判的レビュー + Agent Skills 標準に基づく修正版**
> 作成: 2026-01-29

---

## 批判的レビュー結果サマリー

### レビュアー評価

| レビュアー | スコア | 主要指摘 |
|-----------|--------|---------|
| Codex (アーキテクト) | 65/100 | 認証なし、テストなし、AI抽象化欠如 |
| Gemini (UI/UX) | 7/20 | Focus Stack UIは矛盾、アクセシビリティ違反 |
| GLM (コード品質) | 4/7 | 実行時バリデーション欠如、型安全性不足 |
| Claude (統合) | - | 見積もり甘い（4週→6週が現実的） |

### CRITICAL Issues（即時対応）

1. **API 認証なし** - 全エンドポイントが無防備
2. **テストなし** - カバレッジ 0%
3. **Focus Stack UI は廃止** - 高密度リストUIに変更
4. **アクセシビリティ違反** - キーボード操作必須
5. **Hammer.js 削除** - PWAには過剰
6. **実行時バリデーション追加** - Zod を API で使用

---

## Agent Skills 標準への準拠

### 現状の FUGUE スキル構造

```
~/.claude/skills/harness/
├── SKILL.md           # 説明テキストのみ
├── scripts/           # 実行スクリプト
└── (frontmatter なし)
```

### Agent Skills 標準構造

```
strategic-advisor/
├── SKILL.md           # YAML frontmatter 必須
│   ---
│   name: strategic-advisor
│   description: FUGUE の戦略的アドバイザー。開発者に本質的な提案を行う。
│   license: MIT
│   compatibility: Claude Code, Cursor
│   metadata:
│     author: FUGUE
│     version: "1.0"
│   ---
│   [Markdown body]
├── scripts/
│   └── generate-insights.ts
├── references/
│   ├── INSIGHT_PATTERNS.md
│   └── UI_GUIDELINES.md
└── assets/
    └── schemas/
```

### 移行計画

1. **Phase 1**: 既存スキルに YAML frontmatter 追加
2. **Phase 2**: skills-ref による検証導入
3. **Phase 3**: ポータビリティテスト（Cursor での動作確認）

---

## 修正版アーキテクチャ

### UI/UX 方針転換（Gemini 指摘対応）

**廃止:**
- ❌ Focus Stack UI（カードスタック）
- ❌ スワイプジェスチャー（Hammer.js）
- ❌ Tinder 風インタラクション

**採用:**
- ✅ **高密度リストUI**（Linear スタイル）
- ✅ **キーボードショートカット**（J/K移動、Enter決定）
- ✅ **Progressive Disclosure**（タップで展開）
- ✅ **アクセシブルなボタン**（Accept/Dismiss/Snooze）

```
┌─────────────────────────────────────────────┐
│ 💡 Insights (3)                    [J/K移動] │
├─────────────────────────────────────────────┤
│ ▸ [Strategic] 認証と決済の統合       80%    │
│   → 認証と決済で重複パターン検出            │
│   [Accept] [Dismiss] [Snooze]               │
├─────────────────────────────────────────────┤
│   [Tactical] タスク分割を検討        65%    │
├─────────────────────────────────────────────┤
│   [Reflective] 開発ペース向上中      90%    │
└─────────────────────────────────────────────┘
```

### セキュリティ強化（Codex 指摘対応）

```typescript
// handlers/strategic-advisor-api.ts
import { requireAuth } from '../utils/jwt-auth';
import { authenticateWithAccess } from '../utils/cloudflare-access';

export async function handleAdvisorAPI(
  request: Request,
  env: Env,
  path: string
): Promise<Response> {
  // 認証必須
  const accessResult = await authenticateWithAccess(request, env);
  if (!accessResult.verified) {
    const jwtResult = await requireAuth(request, env);
    if (!jwtResult.authenticated) {
      return errorResponse('Unauthorized', 401);
    }
  }
  // ...
}
```

### 実行時バリデーション強化（GLM 指摘対応）

```typescript
// handlers/strategic-advisor-api.ts
export async function handleSyncPlans(
  request: Request,
  env: Env
): Promise<Response> {
  // Zod による実行時バリデーション
  const SyncRequestSchema = z.object({
    content: z.string().min(1).max(1_000_000),
    filePath: z.string().regex(/^[a-zA-Z0-9_\-\/]+\.md$/),
  });

  const body = await request.json();
  const parsed = SyncRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(`Validation error: ${parsed.error.message}`);
  }
  // ...
}
```

### AI プロバイダー抽象化（Codex 指摘対応）

```typescript
// services/ai-provider.ts
interface AIProvider {
  analyze(prompt: string, context: string): Promise<string>;
  estimateComplexity(task: string): number;
}

class WorkersAIProvider implements AIProvider { /* ... */ }
class ClaudeAPIProvider implements AIProvider { /* ... */ }

// 複雑度に応じた自動選択
function selectProvider(complexity: number, env: Env): AIProvider {
  if (complexity > 0.7 && env.ANTHROPIC_API_KEY) {
    return new ClaudeAPIProvider(env);
  }
  return new WorkersAIProvider(env);
}
```

### ルールエンジン導入（Codex 指摘対応）

```typescript
// services/insight-rules.ts
interface InsightRule {
  id: string;
  name: string;
  trigger: (context: StrategicContext) => boolean;
  generate: (context: StrategicContext) => Insight | null;
  priority: number;
  config: Record<string, unknown>; // ユーザー設定可能
}

// 設定可能なルール
const DEFAULT_RULES: InsightRule[] = [
  {
    id: 'stuck-tasks',
    name: '滞留タスク検出',
    trigger: (ctx) => ctx.goals.some(g =>
      g.status === 'active' &&
      g.successCriteria.length > (ctx.config?.stuckThreshold ?? 3)
    ),
    generate: (ctx) => ({ /* ... */ }),
    priority: 1,
    config: { stuckThreshold: 3 }, // カスタマイズ可能
  },
  // ...
];
```

---

## 修正版実装フェーズ

### Phase 1: 基盤修正（1週目）
- [x] スキーマ定義
- [x] Plans.md パーサー（基本版）
- [ ] **認証追加** ← NEW
- [ ] **実行時バリデーション追加** ← NEW
- [ ] **ユニットテスト作成** ← NEW
- [ ] Agent Skills frontmatter 追加

### Phase 2: Intelligence（2週目）
- [ ] AI プロバイダー抽象化
- [ ] ルールエンジン導入
- [ ] パーサー堅牢化（remark/unified）
- [ ] エラーハンドリング改善

### Phase 3: UI 再設計（3週目）
- [ ] **高密度リストUI** ← 変更
- [ ] **キーボードショートカット** ← 変更
- [ ] Progressive Disclosure
- [ ] アクセシビリティ対応

### Phase 4: 配信・フィードバック（4週目）
- [ ] Push 通知（高優先度のみ）
- [ ] フィードバック追跡
- [ ] 重要度自動調整

### Phase 5: 品質保証（5-6週目）
- [ ] テストカバレッジ 80%
- [ ] skills-ref 検証
- [ ] Cursor 互換性テスト
- [ ] パフォーマンステスト

---

## 修正版成功指標

| 指標 | 旧目標 | 修正目標 |
|------|--------|---------|
| 実装期間 | 4週間 | **6週間** |
| テストカバレッジ | - | **80%** |
| API 認証 | なし | **必須** |
| UI パターン | Focus Stack | **高密度リスト** |
| Agent Skills 準拠 | なし | **完全準拠** |
| キーボード操作 | なし | **J/K/Enter** |

---

## リスク軽減策

| リスク | 対策 |
|--------|------|
| 見積もり超過 | バッファ 2週間追加済み |
| UI 変更の影響 | A/Bテスト実施 |
| Agent Skills 標準変更 | Anthropic GitHub watch |
| パフォーマンス問題 | Progressive Disclosure 徹底 |

---

## 次のアクション

1. **即時**: API 認証追加
2. **即時**: ユニットテスト作成（plans-parser.ts）
3. **Phase 2 前**: AI プロバイダー抽象化
4. **Phase 3 前**: UI 方針を高密度リストに変更

---

## 参考リソース

- [Agent Skills 仕様](https://agentskills.io/specification)
- [skills-ref 検証ライブラリ](https://github.com/agentskills/agentskills/tree/main/skills-ref)
- [Anthropic 公式スキル例](https://github.com/anthropics/skills)
- [Linear Triage Intelligence](https://linear.app/method)
