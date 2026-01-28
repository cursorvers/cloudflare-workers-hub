# FUGUE Cockpit Local Agent - アーキテクチャ

## 全体構成

```
┌─────────────────────────────────────────────────────────────┐
│                    Cloudflare Workers Hub                    │
│                 (orchestrator-hub.workers.dev)               │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              WebSocket Server (/ws)                  │   │
│  │  - 認証（Bearer Token）                              │   │
│  │  - メッセージルーティング                             │   │
│  │  - Ping/Pong ヘルスチェック                          │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                            ▲ WebSocket
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                  FUGUE Cockpit Local Agent                   │
│                      (Mac ローカル実行)                      │
│                                                               │
│  ┌────────────────────┐  ┌────────────────────┐            │
│  │   WebSocket Client │  │   Git Monitor      │            │
│  │  - 自動再接続      │  │  - リポジトリ監視   │            │
│  │  - メッセージ送受信│  │  - 変更検出         │            │
│  │  - Ping/Pong       │  │  - 定期チェック     │            │
│  └────────────────────┘  └────────────────────┘            │
│           │                       │                          │
│           │                       │                          │
│           ▼                       ▼                          │
│  ┌────────────────────────────────────────────────┐        │
│  │              Task Executor                      │        │
│  │  - Bash コマンド実行                            │        │
│  │  - Git コマンド実行                             │        │
│  │  - Claude Code 実行（予定）                     │        │
│  │  - Codex 実行（予定）                           │        │
│  └────────────────────────────────────────────────┘        │
│           │                                                  │
│           ▼                                                  │
│  ┌────────────────────────────────────────────────┐        │
│  │         Config Manager (Zod Validation)         │        │
│  └────────────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
                  ┌───────────────────┐
                  │  Git Repositories  │
                  │  - Repo 1          │
                  │  - Repo 2          │
                  │  - Repo 3          │
                  └───────────────────┘
```

## コンポーネント詳細

### 1. WebSocket Client

**責務**: Workers Hub との通信

```typescript
class LocalAgent {
  private ws: WebSocket | null;

  // 接続管理
  connectToHub(): void
  scheduleReconnect(): void  // 5秒後に再接続

  // メッセージ送信
  send(message: object): void
  sendAgentStatus(status: 'online' | 'offline'): void
  sendGitStatuses(statuses: GitStatus[]): void
  sendTaskResult(result: TaskResult): void
  sendPong(): void

  // メッセージ受信
  handleMessage(message: string): void
  handleTask(task: Task): void
}
```

**特徴**:
- 自動再接続（5秒間隔）
- Bearer Token 認証
- Ping/Pong ヘルスチェック

### 2. Git Monitor

**責務**: Git リポジトリの状態監視

```typescript
class GitMonitor {
  // 状態取得
  getStatus(): Promise<GitStatus>
  hasChanges(currentStatus: GitStatus): boolean
  isGitRepository(): Promise<boolean>
}

class MultiRepoMonitor {
  // 複数リポジトリ管理
  getAllStatuses(): Promise<GitStatus[]>
  getChangedStatuses(): Promise<GitStatus[]>
  addRepository(path: string): void
  removeRepository(path: string): void
}
```

**監視内容**:
- ブランチ名
- ahead/behind カウント
- 変更ファイル（modified, created, deleted, renamed）
- コンフリクト
- Dirty 状態

**実装**:
- `simple-git` を使用
- 定期的にチェック（デフォルト: 60秒）
- 変更があった場合のみ Workers Hub に報告

### 3. Task Executor

**責務**: Workers Hub からのタスク実行

```typescript
class TaskExecutor {
  // タスク実行
  execute(task: Task): Promise<TaskResult>

  // タイプ別実行
  private executeBash(task: Task): Promise<TaskResult>
  private executeGit(task: Task): Promise<TaskResult>
  private executeClaudeCode(task: Task): Promise<TaskResult>  // 予定
  private executeCodex(task: Task): Promise<TaskResult>       // 予定

  // タスク管理
  cancel(taskId: string): boolean
  getRunningTasks(): string[]
}
```

**タスクタイプ**:
- `bash`: 任意の Bash コマンド
- `git`: Git コマンド
- `claude-code`: Claude Code 実行（未実装）
- `codex`: Codex 実行（未実装）

**機能**:
- 標準出力/エラー出力のキャプチャ
- タイムアウト処理
- 実行結果の構造化

### 4. Config Manager

**責務**: 設定ファイルの読み込みとバリデーション

```typescript
// 設定スキーマ（Zod）
const ConfigSchema = z.object({
  repositories: z.array(z.string()),
  checkInterval: z.number().min(1000),
  workersHubUrl: z.string().url(),
  tunnelPort: z.number().min(1).max(65535),
  agent: z.object({
    id: z.string(),
    name: z.string(),
    capabilities: z.array(z.string()),
  }),
  authentication: z.object({
    apiKey: z.string(),
  }),
});

// 読み込み
loadConfig(configPath: string): Config
validateConfig(configPath: string): boolean
```

**機能**:
- JSON 設定ファイル読み込み
- Zod でスキーマバリデーション
- チルダ展開（`~` → ホームディレクトリ）
- 型安全な設定アクセス

## データフロー

### 起動フロー

```
1. エージェント起動
   ├─ 設定ファイル読み込み
   ├─ Git Monitor 初期化
   ├─ Task Executor 初期化
   └─ WebSocket 接続

2. WebSocket 接続完了
   ├─ "online" ステータス送信
   └─ Git 監視開始

3. 定期チェック開始
   └─ 60秒ごとに Git 状態確認
```

### Git 状態報告フロー

```
定期チェック（60秒）
    ↓
リポジトリ状態取得
    ↓
前回との差分確認
    ↓
変更あり？
├─ Yes → Workers Hub に送信
└─ No  → スキップ
```

### タスク実行フロー

```
Workers Hub からタスク受信
    ↓
Task Executor に委譲
    ↓
タスクタイプ判定
├─ bash → Bash 実行
├─ git  → Git 実行
├─ claude-code → Claude Code 実行（予定）
└─ codex → Codex 実行（予定）
    ↓
実行結果をキャプチャ
    ↓
Workers Hub に結果送信
```

### 再接続フロー

```
WebSocket 切断検出
    ↓
5秒待機
    ↓
再接続試行
├─ 成功 → "online" 送信
└─ 失敗 → 再度5秒待機
```

## メッセージフォーマット

### Local Agent → Workers Hub

#### 1. エージェントステータス
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

#### 2. Git ステータス
```json
{
  "type": "git-status",
  "agentId": "local-mac-agent-001",
  "statuses": [
    {
      "path": "/Users/masayuki/Dev/repo",
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

#### 3. タスク結果
```json
{
  "type": "task-result",
  "agentId": "local-mac-agent-001",
  "result": {
    "id": "task-123",
    "success": true,
    "stdout": "output",
    "stderr": "",
    "exitCode": 0,
    "startTime": "2026-01-28T12:00:00Z",
    "endTime": "2026-01-28T12:00:05Z",
    "duration": 5000
  },
  "timestamp": "2026-01-28T12:00:05Z"
}
```

#### 4. Pong
```json
{
  "type": "pong",
  "agentId": "local-mac-agent-001",
  "timestamp": "2026-01-28T12:00:00Z"
}
```

### Workers Hub → Local Agent

#### 1. タスク指示
```json
{
  "type": "task",
  "task": {
    "id": "task-123",
    "type": "git",
    "command": "status",
    "args": ["--short"],
    "workingDir": "/path/to/repo",
    "timeout": 30000
  }
}
```

#### 2. Ping
```json
{
  "type": "ping"
}
```

#### 3. ステータス要求
```json
{
  "type": "status-request"
}
```

## エラーハンドリング

### WebSocket エラー

| エラー | 対応 |
|--------|------|
| 接続失敗 | 5秒後に再接続 |
| 認証失敗 | エラーログ、終了 |
| タイムアウト | 再接続 |

### Git エラー

| エラー | 対応 |
|--------|------|
| リポジトリが存在しない | 警告ログ、スキップ |
| Git が見つからない | エラーログ、終了 |
| 権限エラー | 警告ログ、スキップ |

### タスク実行エラー

| エラー | 対応 |
|--------|------|
| コマンドが見つからない | エラー結果を返す |
| タイムアウト | プロセスを終了、エラー結果を返す |
| 実行権限エラー | エラー結果を返す |

## セキュリティ

### 認証
- Bearer Token 方式
- API キーは `config.json` で管理
- 将来的には環境変数に移行予定

### タスク実行
- ⚠️ 現在は任意のコマンドを実行可能
- ⚠️ 将来的にはホワイトリスト方式を検討

### 設定ファイル
- `config.json` は `.gitignore` に含まれる
- API キーは平文保存（将来的には暗号化予定）

## パフォーマンス

### Git 監視
- 変更があった場合のみ送信
- 60秒間隔でチェック（設定可能）

### WebSocket
- 双方向通信で効率的
- Ping/Pong でコネクション維持

### タスク実行
- タイムアウト設定可能
- 並列実行は Workers Hub 側で制御

## 拡張性

### プラグイン方式（将来）
```typescript
interface TaskPlugin {
  type: string;
  execute(task: Task): Promise<TaskResult>;
}

class TaskExecutor {
  private plugins: Map<string, TaskPlugin>;

  registerPlugin(plugin: TaskPlugin): void;
  execute(task: Task): Promise<TaskResult>;
}
```

### カスタムチェック（将来）
```typescript
interface RepositoryCheck {
  name: string;
  check(repo: GitMonitor): Promise<CheckResult>;
}
```

## 制限事項

### 現在の制限
- Claude Code 実行は未実装
- Codex 実行は未実装
- タスクのキューイング機能なし
- エラーリトライロジックなし

### 環境依存
- Mac 専用（Linux/Windows は未検証）
- Node.js v20 以上必要
- Git コマンドが必要

## デプロイメント

### 開発環境
```bash
npm run dev  # tsx でホットリロード
```

### 本番環境
```bash
npm run build  # TypeScript → JavaScript
npm start      # Node.js で実行
```

### systemd サービス化（将来）
```ini
[Unit]
Description=FUGUE Cockpit Local Agent

[Service]
ExecStart=/usr/bin/node /path/to/local-agent/dist/index.js
Restart=always

[Install]
WantedBy=multi-user.target
```

## モニタリング

### ログ
- 現在: コンソール出力
- 将来: 構造化ログ、ファイル出力

### メトリクス
- タスク実行回数
- Git 変更検出回数
- WebSocket 再接続回数

### アラート
- WebSocket 切断
- タスク実行失敗
- Git エラー
