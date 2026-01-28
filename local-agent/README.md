# FUGUE Cockpit Local Agent

Mac 上で動作し、Git リポジトリの状態監視とタスク実行を担当するローカルエージェント。

## 概要

FUGUE Cockpit Local Agent は以下を担当します:

1. **Git リポジトリの状態監視**
   - ブランチ、ahead/behind、変更ファイル数を追跡
   - 変更があった場合に Workers Hub に報告

2. **タスク実行**
   - Workers Hub からのタスク指示を受信
   - Git コマンド、Bash コマンド、Claude Code、Codex を実行

3. **Cloudflare Workers Hub との通信**
   - WebSocket で常時接続
   - リアルタイムでステータス報告とタスク受信

## セットアップ

### 1. 依存関係のインストール

```bash
cd local-agent
npm install
```

### 2. 設定ファイルの作成

```bash
cp config.example.json config.json
```

`config.json` を編集:

```json
{
  "repositories": [
    "~/Dev/cloudflare-workers-hub",
    "~/Dev/ai-assistant-daemon"
  ],
  "checkInterval": 60000,
  "workersHubUrl": "https://orchestrator-hub.masa-stage1.workers.dev",
  "tunnelPort": 3100,
  "agent": {
    "id": "local-mac-agent-001",
    "name": "Local Mac Agent",
    "capabilities": [
      "git-monitor",
      "task-execution",
      "claude-code"
    ]
  },
  "authentication": {
    "apiKey": "your-api-key-here"
  }
}
```

### 3. ビルド

```bash
npm run build
```

## 使い方

### 開発モード（ホットリロード）

```bash
npm run dev
```

### 本番モード

```bash
npm start
```

### TypeScript 型チェックのみ

```bash
npm run type-check
```

## アーキテクチャ

```
Local Agent
├── Git Monitor
│   ├── SimpleGit でリポジトリ状態取得
│   ├── 定期的にチェック（デフォルト: 60秒）
│   └── 変更検出時に Workers Hub に報告
│
├── Task Executor
│   ├── Workers Hub からタスク受信
│   ├── タスクタイプに応じて実行
│   │   ├── git: Git コマンド
│   │   ├── bash: Bash コマンド
│   │   ├── claude-code: Claude Code 実行
│   │   └── codex: Codex 実行
│   └── 実行結果を Workers Hub に報告
│
└── WebSocket Client
    ├── Workers Hub に常時接続
    ├── 切断時は自動再接続（5秒間隔）
    └── Ping/Pong でヘルスチェック
```

## メッセージプロトコル

### Local Agent → Workers Hub

#### エージェントステータス
```json
{
  "type": "agent-status",
  "agent": {
    "id": "local-mac-agent-001",
    "name": "Local Mac Agent",
    "capabilities": ["git-monitor", "task-execution"]
  },
  "status": "online",
  "timestamp": "2026-01-28T12:00:00Z"
}
```

#### Git ステータス
```json
{
  "type": "git-status",
  "agentId": "local-mac-agent-001",
  "statuses": [
    {
      "path": "/Users/masayuki/Dev/cloudflare-workers-hub",
      "branch": "main",
      "ahead": 2,
      "behind": 0,
      "modified": 3,
      "created": 1,
      "deleted": 0,
      "renamed": 0,
      "conflicted": [],
      "isDirty": true,
      "lastChecked": "2026-01-28T12:00:00Z"
    }
  ],
  "timestamp": "2026-01-28T12:00:00Z"
}
```

#### タスク結果
```json
{
  "type": "task-result",
  "agentId": "local-mac-agent-001",
  "result": {
    "id": "task-123",
    "success": true,
    "stdout": "コマンド出力",
    "stderr": "",
    "exitCode": 0,
    "startTime": "2026-01-28T12:00:00Z",
    "endTime": "2026-01-28T12:00:05Z",
    "duration": 5000
  },
  "timestamp": "2026-01-28T12:00:05Z"
}
```

### Workers Hub → Local Agent

#### タスク指示
```json
{
  "type": "task",
  "task": {
    "id": "task-123",
    "type": "git",
    "command": "status",
    "args": ["--short"],
    "workingDir": "/Users/masayuki/Dev/cloudflare-workers-hub",
    "timeout": 30000
  }
}
```

#### Ping（ヘルスチェック）
```json
{
  "type": "ping"
}
```

#### ステータス要求
```json
{
  "type": "status-request"
}
```

## 設定項目

| 項目 | 説明 | デフォルト |
|------|------|-----------|
| `repositories` | 監視対象のリポジトリパス（配列） | 必須 |
| `checkInterval` | チェック間隔（ミリ秒） | 60000 (60秒) |
| `workersHubUrl` | Workers Hub の URL | 必須 |
| `tunnelPort` | トンネルポート | 3100 |
| `agent.id` | エージェント ID | 必須 |
| `agent.name` | エージェント名 | 必須 |
| `agent.capabilities` | エージェントの機能リスト | 必須 |
| `authentication.apiKey` | 認証用 API キー | 必須 |

## トラブルシューティング

### WebSocket 接続エラー

```
❌ WebSocket エラー: connect ECONNREFUSED
```

→ Workers Hub が起動しているか確認してください。

### Git リポジトリではない

```
⚠️ /path/to/dir は Git リポジトリではありません
```

→ `repositories` の設定を確認してください。

### 認証エラー

```
❌ WebSocket エラー: Unexpected server response: 401
```

→ `authentication.apiKey` が正しいか確認してください。

## 開発

### ファイル構成

```
local-agent/
├── src/
│   ├── index.ts          # メインエントリーポイント
│   ├── config.ts         # 設定読み込み・バリデーション
│   ├── git-monitor.ts    # Git 状態監視
│   └── task-executor.ts  # タスク実行エンジン
├── package.json
├── tsconfig.json
└── config.example.json
```

### 型安全性

すべての設定とメッセージは Zod でバリデーションされています。

```typescript
import { GitStatusSchema, TaskSchema } from './types.js';

const status = GitStatusSchema.parse(rawStatus);
const task = TaskSchema.parse(rawTask);
```

## ライセンス

MIT
