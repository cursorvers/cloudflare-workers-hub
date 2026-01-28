#!/usr/bin/env node

import WebSocket from 'ws';
import { loadConfig, type Config } from './config.js';
import { MultiRepoMonitor, type GitStatus } from './git-monitor.js';
import { TaskExecutor, type Task, type TaskResult } from './task-executor.js';

/**
 * FUGUE Cockpit Local Agent
 * Mac 上で動作し、Git リポジトリの監視とタスク実行を担当
 */
class LocalAgent {
  private config: Config;
  private monitor: MultiRepoMonitor;
  private executor: TaskExecutor;
  private ws: WebSocket | null = null;
  private checkInterval: NodeJS.Timeout | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;

  constructor(configPath: string = './config.json') {
    this.config = loadConfig(configPath);
    this.monitor = new MultiRepoMonitor(this.config.repositories);
    this.executor = new TaskExecutor();

    console.log('✅ FUGUE Cockpit Local Agent 初期化完了');
    console.log(`📁 監視対象リポジトリ: ${this.config.repositories.length}件`);
    console.log(`🔄 チェック間隔: ${this.config.checkInterval / 1000}秒`);
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
   * Workers Hub に接続
   */
  private async connectToHub(): Promise<void> {
    const wsUrl = this.config.workersHubUrl.replace(/^http/, 'ws') + '/ws';

    console.log(`🔌 Workers Hub に接続中: ${wsUrl}`);

    this.ws = new WebSocket(wsUrl, {
      headers: {
        'Authorization': `Bearer ${this.config.authentication.apiKey}`,
        'X-Agent-Id': this.config.agent.id,
      },
    });

    this.ws.on('open', () => {
      console.log('✅ Workers Hub に接続しました');
      this.sendAgentStatus('online');
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
   */
  private sendAgentStatus(status: 'online' | 'offline'): void {
    this.send({
      type: 'agent-status',
      agent: this.config.agent,
      status,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Git ステータスを送信
   */
  private async sendGitStatuses(statuses?: GitStatus[]): Promise<void> {
    const statusesToSend = statuses || (await this.monitor.getAllStatuses());

    this.send({
      type: 'git-status',
      agentId: this.config.agent.id,
      statuses: statusesToSend,
      timestamp: new Date().toISOString(),
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
