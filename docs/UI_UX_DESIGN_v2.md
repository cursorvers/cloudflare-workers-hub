# FUGUE Cockpit - UI/UX 設計書 v2.0

> **"Ethereal Control & AI Orchestration"**
>
> Designed by: Gemini UI Reviewer (2026 Trends)
> Reviewed by: Codex Security Analyst
> Date: 2026-01-28

---

## デザインコンセプト

**FUGUE 2026**: Liquid Glass + Linear Style + Agentic UX の融合

| トレンド | 採用要素 |
|---------|---------|
| [Liquid Glass (Apple 2026)](https://www.designstudiouiux.com/blog/what-is-glassmorphism-ui-trend/) | 半透明レイヤー、blur(16px) |
| [Linear Style](https://medium.com/design-bootcamp/the-rise-of-linear-style-design-origins-trends-and-techniques-4fd96aab7646) | シャイニングボーダー、ダーク背景 |
| [Agentic UX](https://dev-story.com/blog/mobile-app-ui-ux-design-trends/) | AI が自律的に情報を提示 |
| [Radix Primitives](https://www.radix-ui.com/primitives/case-studies/linear) | アクセシビリティ準拠 |

---

## カラーシステム

### ベースカラー（Ultra Dark）

| 名前 | 値 | 用途 |
|------|-----|------|
| Void Black | `#030304` | 最深背景 |
| Deep Space | `#0A0A0B` | カード背景 |

### ライトエフェクト（Linear Style）

```css
/* シャイニングボーダー */
--shining-border: linear-gradient(
  135deg,
  rgba(255,255,255,0.15) 0%,
  rgba(255,255,255,0.01) 50%,
  rgba(255,255,255,0.05) 100%
);

/* アクティブグロー */
--active-glow: radial-gradient(
  circle at center,
  rgba(120, 119, 198, 0.15) 0%,
  transparent 70%
);

/* カーソルスポットライト */
--cursor-spotlight: radial-gradient(
  600px circle at var(--x) var(--y),
  rgba(255,255,255,0.06),
  transparent 40%
);
```

### ステータスカラー

| 状態 | 値 | 説明 |
|------|-----|------|
| Agent Thinking | `#A855F7` | AI 思考中（紫） |
| Agent Active | `#22D3EE` | AI 実行中（シアン） |
| System Critical | `#F43F5E` | 緊急（ローズ） |
| Success Hologram | `#10B981` | 成功（エメラルド） |

---

## コンポーネント

### 1. Glass Card（Liquid Glass 2026）

```css
.glass-card {
  backdrop-filter: blur(16px) saturate(180%);
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: 0 4px 30px rgba(0, 0, 0, 0.5);
  background: linear-gradient(
    180deg,
    rgba(30, 30, 35, 0.3) 0%,
    rgba(20, 20, 22, 0.1) 100%
  );
  border-radius: 16px;
}
```

**特徴**:
- 境界線は 1px の光で表現
- 影ではなく backdrop-filter で奥行き
- 低スペック端末向けに `will-change: transform` 最適化

### 2. Linear Button

```css
.linear-button {
  background: linear-gradient(180deg, rgba(255,255,255,0.05) 0%, transparent 100%);
  border: 1px solid rgba(255,255,255,0.1);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.05);
  transition: all 0.15s ease;
}

.linear-button:hover {
  border-color: rgba(255,255,255,0.2);
  box-shadow: 0 0 20px rgba(120, 119, 198, 0.2);
}

.linear-button:active {
  transform: scale(0.98); /* Shrink effect */
}
```

### 3. Agent Status Pill

```css
.agent-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 9999px;
  background: rgba(168, 85, 247, 0.1);
  border: 1px solid rgba(168, 85, 247, 0.3);
  animation: breathing 2s ease-in-out infinite;
}

@keyframes breathing {
  0%, 100% { opacity: 0.8; }
  50% { opacity: 1; box-shadow: 0 0 20px rgba(168, 85, 247, 0.3); }
}
```

---

## 画面アップグレード

### Before → After

| 画面 | Before | After | Why |
|------|--------|-------|-----|
| **Dashboard** | 静的グリッド | Contextual Spatial HUD | AI が文脈に応じて情報を浮上させる |
| **Command Center** | フォーム入力 | Intent-based Prompt | 自然言語で意図を伝達 |
| **System Log** | テキストリスト | Timeline + Git Graph | 光のラインで履歴を視覚化 |

### Dashboard（Contextual Spatial HUD）

```
┌─────────────────────────────────────────────────────────┐
│                    ·  ·  ·                              │
│                 ╭──────────────╮                        │
│                 │ 🤖 Claude    │  ← Agent Status Pill   │
│                 │   Thinking   │     (Breathing)        │
│                 ╰──────────────╯                        │
│                                                         │
│    ┌─────────────────────────────────────────────┐     │
│    │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │     │  ← Glass Card
│    │ ░░  Reviewing PR #42                     ░░ │     │     (blur 16px)
│    │ ░░  ━━━━━━━━━░░░░░ 72%                   ░░ │     │
│    │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │     │
│    └─────────────────────────────────────────────┘     │
│                                                         │
│         ╭───────────╮    ╭───────────╮                 │
│         │ ⚠️ 3 dirty │    │ 🚨 1 alert│  ← 重要情報が  │
│         │  repos    │    │           │     浮上        │
│         ╰───────────╯    ╰───────────╯                 │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ [🎤] What would you like to do?              [▶]│   │  ← Intent Input
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  [🔀 Git]  [📋 Tasks]  [⌘ Cmd]  [🔔 Alerts]           │  ← Glassmorphism
│                                                         │     Bottom Bar
└─────────────────────────────────────────────────────────┘
```

---

## WOW Factors（差別化要素）

### 1. Phantom Cursor Tracking
カーソル周囲に微細な粒子が追従し、操作可能な要素に近づくと磁力のように吸着。

### 2. Generative Interfaces
ユーザーの役割に基づき、AI が UI レイアウトを動的に最適化。

### 3. Sound Design Integration
FUGUE（遁走曲）にちなみ、操作に合わせてアンビエントな和音が重なる。

### 4. Spatial Z-Axis Transitions
画面遷移ではなく、カメラが Z 軸方向に移動しレイヤーを潜る体験。

---

## パフォーマンス最適化

| 技術 | 詳細 |
|------|------|
| **GPU Compositing** | 動的背景に静的ブラー画像 + `will-change` で 60fps 維持 |
| **Virtual Scrolling** | 画面外 DOM を削除してメモリ抑制 |
| **Reduced Motion** | システム設定検知で Z 軸移動をフェードに置換 |

---

## アクセシビリティ

| 機能 | 詳細 |
|------|------|
| **Adaptive Contrast** | 背景明度を検知し、WCAG AA を自動維持 |
| **Reduced Motion Mode** | パーティクル効果を自動無効化 |
| **Semantic Focus Rings** | キーボード操作時、要素全体が発光 |
| **Color Blind Support** | アイコン形状で状態を区別 |

---

## セキュリティ設計（Codex レビュー）

| 項目 | スコア | 判定 |
|------|--------|------|
| Security | 7/10 | NEEDS_HARDENING |
| Architecture | 6/10 | ACCEPTABLE |

### 必須対応（本番前）

1. **JWT 詳細検証** - `iat`, `exp`, `aud`, `iss` チェック追加
2. **RBAC 導入** - JWT scopes + Workers Hub ポリシー

### 推奨対応

3. Secret Rotation パイプライン
4. Local Agent コマンドサンドボックス
5. D1 Prepared Statements 徹底

---

## 技術スタック（確定）

| 項目 | 技術 |
|------|------|
| Framework | Next.js 14 (App Router) |
| Styling | Tailwind CSS v4 |
| Components | [shadcn/ui](https://ui.shadcn.com/) |
| Primitives | [Radix UI](https://www.radix-ui.com/) |
| Animation | Framer Motion |
| State | Zustand |
| Real-time | WebSocket (Durable Objects) |

---

## 参考リンク

- [Glassmorphism UI Trend 2026](https://www.designstudiouiux.com/blog/what-is-glassmorphism-ui-trend/)
- [Linear Style Design](https://medium.com/design-bootcamp/the-rise-of-linear-style-design-origins-trends-and-techniques-4fd96aab7646)
- [Mobile App Design Trends 2026](https://uxpilot.ai/blogs/mobile-app-design-trends)
- [Vercel + shadcn/ui Dashboard](https://vercel.com/templates/next.js/next-js-and-shadcn-ui-admin-dashboard)
- [Linear UI Redesign](https://linear.app/now/how-we-redesigned-the-linear-ui)
