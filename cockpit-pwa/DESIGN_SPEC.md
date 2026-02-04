# FUGUE Cockpit - Design Specification

## Overview
Multi-Agent Orchestration Dashboard for mobile-first PWA.

## Design System

### Colors (Dark Mode Primary)
```
--bg-primary: #09090b (zinc-950)
--bg-secondary: #18181b (zinc-900)
--bg-elevated: #27272a (zinc-800)
--border: #3f3f46 (zinc-700)
--text-primary: #fafafa (zinc-50)
--text-secondary: #a1a1aa (zinc-400)
--accent-violet: #8b5cf6
--accent-blue: #3b82f6
--success: #22c55e
--warning: #f59e0b
--error: #ef4444
```

### Typography
- Font: System UI (-apple-system, BlinkMacSystemFont, 'Segoe UI')
- Base: 16px (1rem)
- Scale: 0.75rem, 0.875rem, 1rem, 1.125rem, 1.25rem

### Spacing
- Base: 4px
- Scale: 4, 8, 12, 16, 20, 24, 32, 48, 64

## Layout Structure

```
┌────────────────────────────────┐
│ Header                         │
│ ┌────────────┬───────────────┐ │
│ │ FUGUE      │    ● Online   │ │
│ │ Cockpit    │    [Reconnect]│ │
│ └────────────┴───────────────┘ │
├────────────────────────────────┤
│ Main Content (scrollable)      │
│                                │
│ ┌────────────────────────────┐ │
│ │ Alerts (collapsible)       │ │
│ │ ⚠️ 2 unread                 │ │
│ └────────────────────────────┘ │
│                                │
│ ┌────────────────────────────┐ │
│ │ Message Log (collapsible)  │ │
│ │ Last 3 messages            │ │
│ └────────────────────────────┘ │
│                                │
│ ┌────────────────────────────┐ │
│ │ Tasks                      │ │
│ │ ├─ Task 1 [pending]        │ │
│ │ ├─ Task 2 [running]        │ │
│ │ └─ Task 3 [completed]      │ │
│ └────────────────────────────┘ │
│                                │
│ ┌────────────────────────────┐ │
│ │ Git Repositories           │ │
│ │ ├─ repo-1 [15 changes]     │ │
│ │ ├─ repo-2 [1 change]       │ │
│ │ └─ repo-3 [8 changes]      │ │
│ └────────────────────────────┘ │
│                                │
│ ┌────────────────────────────┐ │
│ │ Providers                  │ │
│ │ ├─ Claude [healthy]        │ │
│ │ ├─ Codex [healthy]         │ │
│ │ └─ GLM [degraded]          │ │
│ └────────────────────────────┘ │
│                                │
│ ┌────────────────────────────┐ │
│ │ Daemons                    │ │
│ │ └─ mac-mini-1 [online]     │ │
│ └────────────────────────────┘ │
│                                │
├────────────────────────────────┤
│ Command Input (fixed bottom)   │
│ ┌────────────────────────────┐ │
│ │ [Message... or /command  ] │ │
│ └────────────────────────────┘ │
└────────────────────────────────┘
```

## Component Specifications

### 1. Header
- Fixed top position
- Safe area inset support (iOS)
- Height: 56px + safe-area-inset-top
- Logo: "FUGUE Cockpit" (left)
- Connection status (right): dot indicator + label

### 2. Section Card
- Background: bg-secondary
- Border: 1px solid border
- Border radius: 12px
- Padding: 16px
- Collapsible with animation (200ms ease-out)
- Section title: text-secondary, uppercase, 0.75rem

### 3. List Item
- Min height: 48px (touch target)
- Horizontal padding: 16px
- Vertical padding: 12px
- Border bottom: 1px solid border (except last)
- Hover/focus: bg-elevated

### 4. Status Badges
```
healthy:   bg-success/20, text-success
degraded:  bg-warning/20, text-warning
unhealthy: bg-error/20, text-error
pending:   bg-zinc-700, text-zinc-300
running:   bg-blue-500/20, text-blue-400
completed: bg-success/20, text-success
```

### 5. Command Input
- Fixed bottom position
- Height: 48px + safe-area-inset-bottom
- Background: bg-secondary
- Border top: 1px solid border
- Input: full width, rounded-lg
- Placeholder: "メッセージを入力... または /コマンド"

## Interactions

### Swipe Gestures
- Right swipe: Accept/Approve action
- Left swipe: Dismiss/Reject action
- Threshold: 80px or 0.3 velocity

### Keyboard Shortcuts
- J/K: Navigate list items
- Enter: Open detail sheet
- A: Accept action
- X: Dismiss action
- S: Snooze action

### Toast Notifications
- Position: top-center
- Duration: 3000ms (info), 5000ms (error)
- Swipe to dismiss

## Accessibility

### WCAG AA Compliance
- Contrast ratio: 4.5:1 minimum
- Touch targets: 44x44px minimum
- Focus indicators: 2px ring
- Screen reader labels for icons

### Reduced Motion
- Respect prefers-reduced-motion
- Disable animations when enabled

## Responsive Breakpoints

```
sm: 640px   (tablet portrait)
md: 768px   (tablet landscape)
lg: 1024px  (desktop)
```

## PWA Manifest

```json
{
  "name": "FUGUE Cockpit",
  "short_name": "Cockpit",
  "display": "standalone",
  "orientation": "portrait-primary",
  "theme_color": "#09090b",
  "background_color": "#09090b"
}
```

## Implementation Priority

1. **P0**: Header, Connection Status, Command Input
2. **P1**: Tasks, Git Repos, Alerts
3. **P2**: Providers, Daemons, Message Log
4. **P3**: Swipe gestures, Keyboard shortcuts

---

*Created for Pencil.dev implementation*
*Date: 2026-01-30*
