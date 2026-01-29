#!/usr/bin/env node

import 'dotenv/config';
import WebSocket from 'ws';
import { loadConfig, type Config } from './config.js';
import { MultiRepoMonitor, type GitStatus } from './git-monitor.js';
import { TaskExecutor, type Task, type TaskResult } from './task-executor.js';
import { ObservabilitySync } from './observability-sync.js';

/**
 * FUGUE Cockpit Local Agent
 * Mac 上で動作し、Git リポジトリの監視とタスク実行を担当
 */
class LocalAgent {
  private config: Config;
  private monitor: MultiRepoMonitor;
  private executor: TaskExecutor;
  private observability: ObservabilitySync;
  private ws: WebSocket | null = null;
  private checkInterval: NodeJS.Timeout | null = null;
  private observabilityInterval: NodeJS.Timeout | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;

  constructor(configPath: string = './config.json') {
    this.config = loadConfig(configPath);
    this.monitor = new MultiRepoMonitor(this.config.repositories);
    this.executor = new TaskExecutor();
    this.observability = new ObservabilitySync();

    console.log('✅ FUGUE Cockpit Local Agent 初期化完了');
    console.log(`📁 監視対象リポジトリ: ${this.config.repositories.length}件`);
    console.log(`🔄 チェック間隔: ${this.config.checkInterval / 1000}秒`);
    if (this.config.tunnelEnabled) {
      console.log(`🚇 Cloudflare Tunnel: ${this.config.tunnelHostname || 'Not configured'}`);
    } else {
      console.log('🔗 接続モード: Direct');
    }
    if (this.observability.isAvailable()) {
      console.log('📊 Observability 同期: 有効');
    }
  }

  /**
   * エージェントを起動
   */
  async start(): Promise<void> {
    console.log('🚀 Local Agent 起動中...');

    // Workers Hub への接続
    await this.connectToHub();

    // Git 監視を開始
    this.startMonitoring();

    // Graceful shutdown
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
  }

  /**
   * 接続先 URL を決定
   * Tunnel が有効な場合は Tunnel 経由、そうでなければ直接接続
   */
  private getConnectionUrl(): string {
    if (this.config.tunnelEnabled && this.config.tunnelHostname) {
      // Cloudflare Tunnel 経由 (wss://)
      return `wss://${this.config.tunnelHostname}/ws`;
    }
    // 直接接続 (workersHubUrl から)
    return this.config.workersHubUrl.replace(/^http/, 'ws') + '/ws';
  }

  /**
   * Workers Hub に接続
   */
  private async connectToHub(): Promise<void> {
    const wsUrl = this.getConnectionUrl();
    const connectionMode = this.config.tunnelEnabled ? 'Tunnel' : 'Direct';

    console.log(`🔌 Workers Hub に接続中 (${connectionMode}): ${wsUrl}`);

    this.ws = new WebSocket(wsUrl, {
      headers: {
        'X-API-Key': this.config.authentication.apiKey,
        'X-Agent-Id': this.config.agent.id,
      },
    });

    this.ws.on('open', async () => {
      console.log('✅ Workers Hub に接続しました');
      this.sendAgentStatus('online');
      // 接続後すぐに Git ステータスを送信
      await this.sendGitStatuses();
    });

    this.ws.on('message', (data) => {
      this.handleMessage(data.toString());
    });

    this.ws.on('close', () => {
      console.log('⚠️ Workers Hub との接続が切断されました');
      this.scheduleReconnect();
    });

    this.ws.on('error', (error) => {
      console.error('❌ WebSocket エラー:', error.message);
    });
  }

  /**
   * 再接続をスケジュール
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimeout) return;

    console.log('🔄 5秒後に再接続を試みます...');
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connectToHub();
    }, 5000);
  }

  /**
   * Workers Hub からのメッセージを処理
   */
  private async handleMessage(message: string): Promise<void> {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case 'task':
          await this.handleTask(data.task);
          break;
        case 'ping':
          this.sendPong();
          break;
        case 'status-request':
          await this.sendGitStatuses();
          break;
        default:
          console.warn('未知のメッセージタイプ:', data.type);
      }
    } catch (error) {
      console.error('メッセージ処理エラー:', error);
    }
  }

  /**
   * タスクを処理
   */
  private async handleTask(task: Task): Promise<void> {
    console.log(`📋 タスク受信: ${task.id} (${task.type})`);

    try {
      const result = await this.executor.execute(task);
      this.sendTaskResult(result);

      if (result.success) {
        console.log(`✅ タスク完了: ${task.id}`);
      } else {
        console.log(`❌ タスク失敗: ${task.id} - ${result.error || result.stderr}`);
      }
    } catch (error) {
      console.error(`❌ タスク実行エラー: ${task.id}`, error);
    }
  }

  /**
   * Git 監視を開始
   */
  private startMonitoring(): void {
    console.log('👁️ Git 監視を開始します');

    // 初回実行
    this.checkRepositories();

    // 定期実行
    this.checkInterval = setInterval(() => {
      this.checkRepositories();
    }, this.config.checkInterval);

    // Observability 同期 (60秒ごと)
    if (this.observability.isAvailable()) {
      this.syncObservability(); // 初回
      this.observabilityInterval = setInterval(() => {
        this.syncObservability();
      }, 60000);
    }
  }

  /**
   * Observability データを同期
   */
  private syncObservability(): void {
    try {
      const data = this.observability.collectSyncData();
      this.send(data);
      console.log('📊 Observability 同期完了');
    } catch (error) {
      console.error('Observability 同期エラー:', error);
    }
  }

  /**
   * リポジトリをチェック
   */
  private async checkRepositories(): Promise<void> {
    try {
      const statuses = await this.monitor.getAllStatuses();

      // 変更があった場合のみ送信
      const changes = statuses.filter((status) => {
        const monitor = this.monitor['monitors'].get(status.path);
        return monitor?.hasChanges(status);
      });

      if (changes.length > 0) {
        console.log(`🔄 変更検出: ${changes.length}件`);
        this.sendGitStatuses(changes);
      }
    } catch (error) {
      console.error('リポジトリチェックエラー:', error);
    }
  }

  /**
   * Workers Hub にメッセージを送信
   */
  private send(message: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.warn('⚠️ WebSocket が接続されていません');
    }
  }

  /**
   * エージェントステータスを送信
   * CockpitWebSocket が期待する形式に合わせる
   */
  private sendAgentStatus(status: 'online' | 'offline'): void {
    this.send({
      type: 'agent-status',
      agentId: this.config.agent.id,
      status,
      capabilities: this.config.agent.capabilities,
      metadata: { name: this.config.agent.name },
    });
  }

  /**
   * Git ステータスを送信
   * CockpitWebSocket DO が期待する形式に変換
   */
  private async sendGitStatuses(statuses?: GitStatus[]): Promise<void> {
    const statusesToSend = statuses || (await this.monitor.getAllStatuses());

    // Transform to CockpitWebSocket expected format
    const repos = statusesToSend.map((status) => {
      // Extract repo name from path
      const pathParts = status.path.split('/');
      const name = pathParts[pathParts.length - 1] || status.path;

      // Determine status based on dirty flag and ahead/behind counts
      let repoStatus: 'clean' | 'dirty' | 'ahead' | 'behind' | 'diverged' = 'clean';
      if (status.isDirty) {
        repoStatus = 'dirty';
      } else if (status.ahead > 0 && status.behind > 0) {
        repoStatus = 'diverged';
      } else if (status.ahead > 0) {
        repoStatus = 'ahead';
      } else if (status.behind > 0) {
        repoStatus = 'behind';
      }

      // Generate stable ID from path
      const id = status.path
        .replace(/[^a-zA-Z0-9]/g, '_')
        .toLowerCase()
        .slice(0, 64);

      return {
        id,
        path: status.path,
        name,
        branch: status.branch,
        status: repoStatus,
        uncommittedCount: status.modified + status.created + status.deleted,
        aheadCount: status.ahead,
        behindCount: status.behind,
        modifiedFiles: [], // Could be populated with actual file names if needed
      };
    });

    this.send({
      type: 'git-status',
      repos,
    });
  }

  /**
   * タスク結果を送信
   */
  private sendTaskResult(result: TaskResult): void {
    this.send({
      type: 'task-result',
      agentId: this.config.agent.id,
      result,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Pong を送信
   */
  private sendPong(): void {
    this.send({
      type: 'pong',
      agentId: this.config.agent.id,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * エージェントを停止
   */
  async stop(): Promise<void> {
    console.log('\n🛑 Local Agent を停止中...');

    // 監視を停止
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    // Observability 同期を停止
    if (this.observabilityInterval) {
      clearInterval(this.observabilityInterval);
      this.observabilityInterval = null;
    }
    this.observability.close();

    // 再接続タイマーをクリア
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // オフライン通知
    this.sendAgentStatus('offline');

    // WebSocket を閉じる
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    console.log('✅ Local Agent を停止しました');
    process.exit(0);
  }
}

// エントリーポイント
async function main() {
  const configPath = process.argv[2] || './config.json';

  try {
    const agent = new LocalAgent(configPath);
    await agent.start();
  } catch (error) {
    console.error('❌ 起動エラー:', error);
    process.exit(1);
  }
}

// スクリプトとして直接実行された場合のみ起動
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { LocalAgent };
