import simpleGit, { SimpleGit, StatusResult } from 'simple-git';
import { z } from 'zod';

/**
 * Git リポジトリの状態
 */
export const GitStatusSchema = z.object({
  path: z.string(),
  branch: z.string(),
  ahead: z.number(),
  behind: z.number(),
  modified: z.number(),
  created: z.number(),
  deleted: z.number(),
  renamed: z.number(),
  conflicted: z.array(z.string()),
  isDirty: z.boolean(),
  lastChecked: z.string(),
});

export type GitStatus = z.infer<typeof GitStatusSchema>;

/**
 * Git リポジトリの状態監視
 */
export class GitMonitor {
  private git: SimpleGit;
  private repositoryPath: string;
  private lastStatus: GitStatus | null = null;

  constructor(repositoryPath: string) {
    this.repositoryPath = repositoryPath;
    this.git = simpleGit(repositoryPath);
  }

  /**
   * リポジトリの現在の状態を取得
   */
  async getStatus(): Promise<GitStatus> {
    try {
      // Git status を取得
      const status: StatusResult = await this.git.status();

      // ブランチ情報を取得
      const branch = await this.git.revparse(['--abbrev-ref', 'HEAD']);

      // リモートとの差分を取得（ahead/behind）
      let ahead = 0;
      let behind = 0;
      try {
        const remoteBranch = `origin/${branch.trim()}`;
        const revList = await this.git.raw(['rev-list', '--left-right', '--count', `${remoteBranch}...HEAD`]);
        const [behindStr, aheadStr] = revList.trim().split(/\s+/);
        behind = parseInt(behindStr, 10) || 0;
        ahead = parseInt(aheadStr, 10) || 0;
      } catch {
        // リモートブランチが存在しない場合はスキップ
      }

      const gitStatus: GitStatus = {
        path: this.repositoryPath,
        branch: branch.trim(),
        ahead,
        behind,
        modified: status.modified.length,
        created: status.created.length,
        deleted: status.deleted.length,
        renamed: status.renamed.length,
        conflicted: status.conflicted,
        isDirty: !status.isClean(),
        lastChecked: new Date().toISOString(),
      };

      this.lastStatus = gitStatus;
      return gitStatus;
    } catch (error) {
      throw new Error(`Git status の取得に失敗: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 前回の状態と比較して変更があるか確認
   */
  hasChanges(currentStatus: GitStatus): boolean {
    if (!this.lastStatus) return true;

    return (
      this.lastStatus.branch !== currentStatus.branch ||
      this.lastStatus.ahead !== currentStatus.ahead ||
      this.lastStatus.behind !== currentStatus.behind ||
      this.lastStatus.modified !== currentStatus.modified ||
      this.lastStatus.created !== currentStatus.created ||
      this.lastStatus.deleted !== currentStatus.deleted
    );
  }

  /**
   * リポジトリが Git リポジトリかどうか確認
   */
  async isGitRepository(): Promise<boolean> {
    try {
      await this.git.checkIsRepo();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 前回の状態を取得
   */
  getLastStatus(): GitStatus | null {
    return this.lastStatus;
  }
}

/**
 * 複数のリポジトリを監視
 */
export class MultiRepoMonitor {
  private monitors: Map<string, GitMonitor> = new Map();

  constructor(repositoryPaths: string[]) {
    for (const path of repositoryPaths) {
      this.monitors.set(path, new GitMonitor(path));
    }
  }

  /**
   * すべてのリポジトリの状態を取得
   */
  async getAllStatuses(): Promise<GitStatus[]> {
    const statuses: GitStatus[] = [];

    for (const [path, monitor] of this.monitors.entries()) {
      try {
        const isRepo = await monitor.isGitRepository();
        if (!isRepo) {
          console.warn(`${path} は Git リポジトリではありません`);
          continue;
        }

        const status = await monitor.getStatus();
        statuses.push(status);
      } catch (error) {
        console.error(`${path} の状態取得に失敗:`, error);
      }
    }

    return statuses;
  }

  /**
   * 変更があったリポジトリのみ取得
   */
  async getChangedStatuses(): Promise<GitStatus[]> {
    const allStatuses = await this.getAllStatuses();
    return allStatuses.filter((status) => {
      const monitor = this.monitors.get(status.path);
      return monitor ? monitor.hasChanges(status) : false;
    });
  }

  /**
   * 特定のリポジトリの監視を追加
   */
  addRepository(path: string): void {
    if (!this.monitors.has(path)) {
      this.monitors.set(path, new GitMonitor(path));
    }
  }

  /**
   * 特定のリポジトリの監視を削除
   */
  removeRepository(path: string): void {
    this.monitors.delete(path);
  }
}
